# This lifecycle is statically checked on macOS; release it only after a real Windows Trae smoke test.
$Script:TraeSkinVersion = '0.4.0'
$Script:TraeSkinDefaultPort = 9342
$Script:TraeSkinDefaultTheme = 'neon-portal'
$Script:TraeSkinProjectRoot = Split-Path -Parent $PSScriptRoot
$Script:TraeSkinInjector = Join-Path $PSScriptRoot 'injector.mjs'
$Script:TraeSkinThemesRoot = if ($env:TRAE_DREAM_SKIN_THEMES_ROOT) {
  [System.IO.Path]::GetFullPath($env:TRAE_DREAM_SKIN_THEMES_ROOT)
} else {
  Join-Path $Script:TraeSkinProjectRoot 'themes'
}
$Script:TraeSkinStateRoot = if ($env:TRAE_DREAM_SKIN_HOME) {
  [System.IO.Path]::GetFullPath($env:TRAE_DREAM_SKIN_HOME)
} else {
  Join-Path $env:LOCALAPPDATA 'TraeDreamSkin'
}
$Script:TraeSkinStatePath = Join-Path $Script:TraeSkinStateRoot 'state.json'
$Script:TraeSkinStdoutPath = Join-Path $Script:TraeSkinStateRoot 'injector.log'
$Script:TraeSkinStderrPath = Join-Path $Script:TraeSkinStateRoot 'injector-error.log'
$Script:TraeSkinVerifyPath = Join-Path $Script:TraeSkinStateRoot 'last-verify.json'
$Script:TraeSkinAppUserModelId = 'ByteDance.TraeSoloCN'
$Script:TraeSkinLastNodeExitCode = 1
$Script:TraeSkinExecutableNames = @('TRAE SOLO CN.exe', 'trae-solo-cn.exe', 'Trae.exe')
$Script:TraeSkinProductPattern = '(?i)(?:TRAE(?:\s+(?:SOLO|Work))?(?:\s+CN)?|trae-solo-cn)'

# Override only when an official build uses a newer certificate subject.
$Script:TraeSkinPublisherPattern = if ($env:TRAE_EXPECTED_PUBLISHER_SUBJECT_REGEX) {
  $env:TRAE_EXPECTED_PUBLISHER_SUBJECT_REGEX
} else {
  '(?i)(?:Beijing Yinli Catapult Technology Co\.,? Ltd\.?|Beijing Bytedance Technology Co\.,? Ltd\.?|ByteDance(?: Ltd\.)?|Bytedance Pte\.? Ltd\.?)'
}

function Fail-TraeSkin {
  param([Parameter(Mandatory = $true)][string]$Message)
  throw "Trae Dream Skin: $Message"
}

function Enter-TraeSkinOperationLock {
  $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $mutex = [System.Threading.Mutex]::new($false, "Local\TraeDreamSkin.$sid.Operation")
  $acquired = $false
  try {
    $acquired = $mutex.WaitOne(0)
  } catch [System.Threading.AbandonedMutexException] {
    $acquired = $true
  }
  if (-not $acquired) {
    $mutex.Dispose()
    Fail-TraeSkin 'Another start, switch, verify, stop, or status operation is already running.'
  }
  return $mutex
}

function Exit-TraeSkinOperationLock {
  param([Parameter(Mandatory = $true)][System.Threading.Mutex]$Mutex)
  try { $Mutex.ReleaseMutex() } finally { $Mutex.Dispose() }
}

function Assert-TraeSkinWindows {
  if ($env:OS -ne 'Windows_NT') { Fail-TraeSkin 'This script requires Windows.' }
  if (-not $env:LOCALAPPDATA) { Fail-TraeSkin 'LOCALAPPDATA is unavailable.' }
}

function Assert-TraeSkinPort {
  param([Parameter(Mandatory = $true)][int]$Port)
  if ($Port -lt 1024 -or $Port -gt 65535) {
    Fail-TraeSkin "Port must be between 1024 and 65535: $Port"
  }
}

function Test-TraeSkinPathEqual {
  param([string]$Left, [string]$Right)
  if (-not $Left -or -not $Right) { return $false }
  try {
    $leftPath = [System.IO.Path]::GetFullPath($Left).TrimEnd('\')
    $rightPath = [System.IO.Path]::GetFullPath($Right).TrimEnd('\')
    return $leftPath.Equals($rightPath, [System.StringComparison]::OrdinalIgnoreCase)
  } catch {
    return $false
  }
}

function Test-TraeSkinCommandLineToken {
  param([string]$CommandLine, [string]$Token)
  if (-not $CommandLine -or -not $Token) { return $false }
  $pattern = '(?i)(?:^|[\s"])' + [regex]::Escape($Token) + '(?=$|[\s"])'
  return [regex]::IsMatch($CommandLine, $pattern)
}

function Test-TraeSkinCommandLineOptionValue {
  param([string]$CommandLine, [string]$Option, [string]$Value)
  if (-not $CommandLine -or -not $Option -or -not $Value) { return $false }
  $pattern = '(?i)(?:^|[\s"])' + [regex]::Escape($Option) +
    '(?:=|\s+)"?' + [regex]::Escape($Value) + '(?=$|[\s"])'
  return [regex]::IsMatch($CommandLine, $pattern)
}

function ConvertTo-TraeSkinProcessArgument {
  param([Parameter(Mandatory = $true)][AllowEmptyString()][string]$Value)
  if ($Value.Contains('"')) { Fail-TraeSkin 'Process arguments containing a double quote are unsupported.' }
  if ($Value -notmatch '\s') { return $Value }
  $escaped = [regex]::Replace($Value, '(\\+)$', '$1$1')
  return '"' + $escaped + '"'
}

function Get-TraeSkinProcessExecutablePath {
  param([Parameter(Mandatory = $true)][object]$ProcessInfo)
  if ($ProcessInfo.ExecutablePath) { return "$($ProcessInfo.ExecutablePath)" }
  try {
    $process = Get-Process -Id ([int]$ProcessInfo.ProcessId) -ErrorAction Stop
    if ($process.Path) { return "$($process.Path)" }
    return "$($process.MainModule.FileName)"
  } catch {
    return $null
  }
}

function Get-TraeSkinAuthenticodeIdentity {
  param([Parameter(Mandatory = $true)][string]$Executable)
  if (-not (Test-Path -LiteralPath $Executable -PathType Leaf)) { return $null }
  try {
    $signature = Get-AuthenticodeSignature -LiteralPath $Executable -ErrorAction Stop
    if ($signature.Status -ne [System.Management.Automation.SignatureStatus]::Valid -or
      $null -eq $signature.SignerCertificate) {
      return $null
    }
    $subject = "$($signature.SignerCertificate.Subject)"
    if (-not $subject -or $subject -notmatch $Script:TraeSkinPublisherPattern) { return $null }
    return [pscustomobject]@{
      Subject = $subject
      Thumbprint = "$($signature.SignerCertificate.Thumbprint)"
      Status = "$($signature.Status)"
    }
  } catch {
    return $null
  }
}

function ConvertTo-TraeSkinInstall {
  param([Parameter(Mandatory = $true)][string]$Executable)
  try { $fullPath = [System.IO.Path]::GetFullPath($Executable) } catch { return $null }
  if (-not (Test-Path -LiteralPath $fullPath -PathType Leaf)) { return $null }
  $name = [System.IO.Path]::GetFileName($fullPath)
  if ($name -notin $Script:TraeSkinExecutableNames) { return $null }

  try { $versionInfo = [System.Diagnostics.FileVersionInfo]::GetVersionInfo($fullPath) } catch { return $null }
  $identityText = "$($versionInfo.ProductName) $($versionInfo.FileDescription) $($versionInfo.InternalName)"
  if ($identityText -notmatch $Script:TraeSkinProductPattern) { return $null }
  $signature = Get-TraeSkinAuthenticodeIdentity -Executable $fullPath
  if ($null -eq $signature) { return $null }

  $version = "$($versionInfo.ProductVersion)"
  if (-not $version) { $version = "$($versionInfo.FileVersion)" }
  return [pscustomobject]@{
    Executable = $fullPath
    InstallRoot = Split-Path -Parent $fullPath
    Version = $version
    ProductName = "$($versionInfo.ProductName)"
    PublisherSubject = $signature.Subject
    PublisherThumbprint = $signature.Thumbprint
    AppUserModelId = $Script:TraeSkinAppUserModelId
  }
}

function Add-TraeSkinCandidate {
  param(
    [Parameter(Mandatory = $true)][System.Collections.Generic.List[string]]$Candidates,
    [AllowNull()][string]$Path
  )
  if (-not $Path) { return }
  try {
    $expanded = [Environment]::ExpandEnvironmentVariables($Path.Trim())
    if ($expanded -match '^"(?<path>[^"]+\.exe)"(?:,\d+|\s+.*)?$') {
      $expanded = $Matches.path
    } elseif ($expanded -match '^(?<path>.+?\.exe)(?:,\d+|\s+.*)?$') {
      $expanded = $Matches.path.Trim('"')
    }
    $fullPath = [System.IO.Path]::GetFullPath($expanded)
    if (-not $Candidates.Contains($fullPath)) { $null = $Candidates.Add($fullPath) }
  } catch {}
}

function Add-TraeSkinInstallLocationCandidates {
  param(
    [Parameter(Mandatory = $true)][System.Collections.Generic.List[string]]$Candidates,
    [AllowNull()][string]$InstallLocation
  )
  if (-not $InstallLocation) { return }
  foreach ($name in $Script:TraeSkinExecutableNames) {
    Add-TraeSkinCandidate -Candidates $Candidates -Path (Join-Path $InstallLocation $name)
  }
}

function Get-TraeSkinShortcutTarget {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
  try {
    $shell = New-Object -ComObject WScript.Shell
    return "$($shell.CreateShortcut($Path).TargetPath)"
  } catch {
    return $null
  }
}

function Get-TraeSkinInstall {
  $candidates = [System.Collections.Generic.List[string]]::new()
  Add-TraeSkinCandidate -Candidates $candidates -Path $env:TRAE_EXE

  $appPathRoots = @(
    'HKCU:\Software\Microsoft\Windows\CurrentVersion\App Paths',
    'HKLM:\Software\Microsoft\Windows\CurrentVersion\App Paths'
  )
  foreach ($root in $appPathRoots) {
    foreach ($name in $Script:TraeSkinExecutableNames) {
      $key = Join-Path $root $name
      try {
        $value = (Get-Item -LiteralPath $key -ErrorAction Stop).GetValue('')
        Add-TraeSkinCandidate -Candidates $candidates -Path "$value"
      } catch {}
    }
  }

  $applicationRoots = @(
    'HKCU:\Software\Classes\Applications',
    'HKLM:\Software\Classes\Applications'
  )
  foreach ($root in $applicationRoots) {
    foreach ($name in $Script:TraeSkinExecutableNames) {
      $key = Join-Path (Join-Path $root $name) 'shell\open\command'
      try {
        $value = (Get-Item -LiteralPath $key -ErrorAction Stop).GetValue('')
        Add-TraeSkinCandidate -Candidates $candidates -Path "$value"
      } catch {}
    }
  }

  $uninstallRoots = @(
    'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
    'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
    'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall'
  )
  foreach ($root in $uninstallRoots) {
    try {
      foreach ($key in Get-ChildItem -LiteralPath $root -ErrorAction Stop) {
        $item = Get-ItemProperty -LiteralPath $key.PSPath -ErrorAction SilentlyContinue
        if ($null -eq $item) { continue }
        $keyName = "$($key.PSChildName)"
        $displayName = "$($item.DisplayName)"
        if ($keyName -ine 'TRAE SOLO CN' -and $keyName -ine 'trae-solo-cn' -and
          $displayName -notmatch $Script:TraeSkinProductPattern) { continue }
        Add-TraeSkinCandidate -Candidates $candidates -Path "$($item.DisplayIcon)"
        Add-TraeSkinInstallLocationCandidates -Candidates $candidates -InstallLocation "$($item.InstallLocation)"
      }
    } catch {}
  }

  $locations = @()
  if ($env:LOCALAPPDATA) {
    $locations += @(
      (Join-Path $env:LOCALAPPDATA 'Programs\TRAE SOLO CN'),
      (Join-Path $env:LOCALAPPDATA 'Programs\trae-solo-cn'),
      (Join-Path $env:LOCALAPPDATA 'Programs\Trae')
    )
  }
  if ($env:ProgramFiles) {
    $locations += @(
      (Join-Path $env:ProgramFiles 'TRAE SOLO CN'),
      (Join-Path $env:ProgramFiles 'trae-solo-cn'),
      (Join-Path $env:ProgramFiles 'Trae')
    )
  }
  $programFilesX86 = [Environment]::GetEnvironmentVariable('ProgramFiles(x86)')
  if ($programFilesX86) {
    $locations += @(
      (Join-Path $programFilesX86 'TRAE SOLO CN'),
      (Join-Path $programFilesX86 'trae-solo-cn')
    )
  }
  foreach ($location in $locations) {
    Add-TraeSkinInstallLocationCandidates -Candidates $candidates -InstallLocation $location
  }

  $shortcutRoots = @(
    (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'),
    (Join-Path $env:ProgramData 'Microsoft\Windows\Start Menu\Programs')
  )
  foreach ($shortcutRoot in $shortcutRoots) {
    if (-not $shortcutRoot -or -not (Test-Path -LiteralPath $shortcutRoot)) { continue }
    try {
      foreach ($shortcut in Get-ChildItem -LiteralPath $shortcutRoot -Filter '*.lnk' -Recurse -ErrorAction SilentlyContinue) {
        if ($shortcut.BaseName -notmatch $Script:TraeSkinProductPattern) { continue }
        Add-TraeSkinCandidate -Candidates $candidates -Path (Get-TraeSkinShortcutTarget -Path $shortcut.FullName)
      }
    } catch {}
  }

  foreach ($name in $Script:TraeSkinExecutableNames) {
    $escapedName = $name.Replace("'", "''")
    try {
      foreach ($process in Get-CimInstance Win32_Process -Filter "Name = '$escapedName'" -ErrorAction SilentlyContinue) {
        Add-TraeSkinCandidate -Candidates $candidates -Path (Get-TraeSkinProcessExecutablePath -ProcessInfo $process)
      }
    } catch {}
  }

  foreach ($candidate in $candidates) {
    $install = ConvertTo-TraeSkinInstall -Executable $candidate
    if ($null -ne $install) { return $install }
  }
  Fail-TraeSkin 'The official signed TRAE SOLO CN installation was not found. Set TRAE_EXE only when auto-discovery misses an official install.'
}

function Get-TraeSkinInstallFromState {
  param([AllowNull()][object]$State)
  if ($null -eq $State -or -not $State.traeExe) { return $null }
  $install = ConvertTo-TraeSkinInstall -Executable "$($State.traeExe)"
  if ($null -eq $install -or -not $State.traePublisherThumbprint -or
    $install.PublisherThumbprint -ine "$($State.traePublisherThumbprint)" -or
    $install.PublisherSubject -ine "$($State.traePublisherSubject)") {
    return $null
  }
  return $install
}

function Ensure-TraeSkinStateRoot {
  New-Item -ItemType Directory -Force -Path $Script:TraeSkinStateRoot | Out-Null
}

function Write-TraeSkinUtf8FileAtomically {
  param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)][string]$Content)
  $directory = Split-Path -Parent ([System.IO.Path]::GetFullPath($Path))
  New-Item -ItemType Directory -Force -Path $directory | Out-Null
  $temporary = Join-Path $directory ('.' + [System.IO.Path]::GetFileName($Path) + '.' + [guid]::NewGuid().ToString('N') + '.tmp')
  try {
    $utf8 = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($temporary, $Content, $utf8)
    if (Test-Path -LiteralPath $Path -PathType Leaf) {
      [System.IO.File]::Replace($temporary, $Path, $null, $true)
    } else {
      [System.IO.File]::Move($temporary, $Path)
    }
  } finally {
    Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
  }
}

function Read-TraeSkinState {
  if (-not (Test-Path -LiteralPath $Script:TraeSkinStatePath -PathType Leaf)) { return $null }
  try {
    $content = [System.IO.File]::ReadAllText($Script:TraeSkinStatePath, [System.Text.Encoding]::UTF8)
    $state = $content | ConvertFrom-Json -ErrorAction Stop
    if ($null -eq $state -or $state -is [string] -or $state -is [array]) { throw 'State root must be an object.' }
    $schemaVersion = 0
    if (-not [int]::TryParse("$($state.schemaVersion)", [ref]$schemaVersion) -or $schemaVersion -ne 2) {
      throw 'State schema version is invalid.'
    }
    if ("$($state.platform)" -ne 'windows') { throw 'State platform is not Windows.' }
    $stateSession = "$($state.session)"
    if ($stateSession -notin @('starting', 'active')) { throw 'State session is invalid.' }
    if ($state.ownsSession -isnot [bool] -or -not $state.ownsSession) {
      throw 'State does not identify an owned skin session.'
    }
    $statePort = 0
    if (-not [int]::TryParse("$($state.port)", [ref]$statePort)) { throw 'State port is invalid.' }
    Assert-TraeSkinPort -Port $statePort
    $statePid = 0
    if ($state.injectorPid -and
      -not [int]::TryParse("$($state.injectorPid)", [ref]$statePid)) {
      throw 'State injector PID is invalid.'
    }
    if ($statePid -lt 0 -or ($statePid -eq 0 -and $state.injectorStartedAt) -or
      ($statePid -gt 0 -and -not $state.injectorStartedAt)) {
      throw 'State injector process identity is invalid.'
    }
    if ($stateSession -eq 'active' -and $statePid -le 0) {
      throw 'Active state injector PID is invalid.'
    }
    $traePid = 0
    if ($null -eq $state.PSObject.Properties['traePid'] -or
      -not [int]::TryParse("$($state.traePid)", [ref]$traePid) -or $traePid -lt 0) {
      throw 'State Trae PID is invalid.'
    }
    if (($traePid -eq 0 -and $state.traeStartedAt) -or
      ($traePid -gt 0 -and -not $state.traeStartedAt)) {
      throw 'State Trae process identity is invalid.'
    }
    $launchTokenValid = Test-TraeSkinLaunchToken -Value "$($state.launchToken)"
    if ($state.launchToken -and -not $launchTokenValid) { throw 'State launch token is invalid.' }
    if ($stateSession -eq 'active' -and $traePid -le 0) { throw 'Active state Trae PID is invalid.' }
    if ($stateSession -eq 'starting' -and $traePid -eq 0 -and -not $launchTokenValid) {
      throw 'Pre-spawn starting state launch token is invalid.'
    }
    if (-not $state.traeExe -or -not $state.runtimePath -or -not $state.injectorPath -or
      -not $state.themeDir -or -not $state.traePublisherSubject -or -not $state.traePublisherThumbprint) {
      throw 'State Trae publisher identity is invalid.'
    }
    if ($stateSession -eq 'active' -and -not (Test-TraeSkinBrowserId -Value "$($state.browserId)")) {
      throw 'Active state browser ID is invalid.'
    }
    if ($stateSession -eq 'starting' -and $state.browserId -and
      -not (Test-TraeSkinBrowserId -Value "$($state.browserId)")) {
      throw 'Starting state browser ID is invalid.'
    }
    if (-not $state.themeId -or "$($state.themeId)" -notmatch '^[a-z0-9][a-z0-9_-]{0,63}$') {
      throw 'State theme ID is invalid.'
    }
    if ($state.themeRevision -and "$($state.themeRevision)" -notmatch '^[a-f0-9]{64}$') {
      throw 'State theme revision is invalid.'
    }
    return $state
  } catch {
    Fail-TraeSkin "State is unreadable and was preserved for inspection: $Script:TraeSkinStatePath"
  }
}

function Write-TraeSkinState {
  param([Parameter(Mandatory = $true)][object]$State)
  $json = $State | ConvertTo-Json -Depth 6
  Write-TraeSkinUtf8FileAtomically -Path $Script:TraeSkinStatePath -Content ($json + "`r`n")
}

function Resolve-TraeSkinTheme {
  param([Parameter(Mandatory = $true)][string]$ThemeId)
  if ($ThemeId -notmatch '^[a-z0-9][a-z0-9_-]{0,63}$') { Fail-TraeSkin "Invalid theme ID: $ThemeId" }
  $themeDirectory = Join-Path $Script:TraeSkinThemesRoot $ThemeId
  if (-not (Test-Path -LiteralPath (Join-Path $themeDirectory 'theme.json') -PathType Leaf)) {
    Fail-TraeSkin "Theme not found: $ThemeId"
  }
  return [pscustomobject]@{ Id = $ThemeId; Directory = $themeDirectory }
}

function Get-TraeSkinThemes {
  if (-not (Test-Path -LiteralPath $Script:TraeSkinThemesRoot -PathType Container)) { return @() }
  return @(Get-ChildItem -LiteralPath $Script:TraeSkinThemesRoot -Directory -ErrorAction Stop |
    Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'theme.json') -PathType Leaf } |
    Sort-Object Name)
}

function Invoke-TraeSkinNode {
  param(
    [Parameter(Mandatory = $true)][object]$Trae,
    [Parameter(Mandatory = $true)][AllowEmptyCollection()][string[]]$NodeArguments
  )
  $savedElectronMode = [Environment]::GetEnvironmentVariable('ELECTRON_RUN_AS_NODE', 'Process')
  $savedNodeOptions = [Environment]::GetEnvironmentVariable('NODE_OPTIONS', 'Process')
  $savedNodeRepl = [Environment]::GetEnvironmentVariable('NODE_REPL_EXTERNAL_MODULE', 'Process')
  try {
    $env:ELECTRON_RUN_AS_NODE = '1'
    Remove-Item Env:NODE_OPTIONS -ErrorAction SilentlyContinue
    Remove-Item Env:NODE_REPL_EXTERNAL_MODULE -ErrorAction SilentlyContinue
    & $Trae.Executable @NodeArguments
    $Script:TraeSkinLastNodeExitCode = $LASTEXITCODE
  } finally {
    if ($null -eq $savedElectronMode) { Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue } else { $env:ELECTRON_RUN_AS_NODE = $savedElectronMode }
    if ($null -eq $savedNodeOptions) { Remove-Item Env:NODE_OPTIONS -ErrorAction SilentlyContinue } else { $env:NODE_OPTIONS = $savedNodeOptions }
    if ($null -eq $savedNodeRepl) { Remove-Item Env:NODE_REPL_EXTERNAL_MODULE -ErrorAction SilentlyContinue } else { $env:NODE_REPL_EXTERNAL_MODULE = $savedNodeRepl }
  }
}

function Get-TraeSkinNodeRuntime {
  param([Parameter(Mandatory = $true)][object]$Trae)
  $output = @(Invoke-TraeSkinNode -Trae $Trae -NodeArguments @('-p', 'process.versions.node') 2>$null)
  $exitCode = $Script:TraeSkinLastNodeExitCode
  $version = if ($output.Count -gt 0) { "$($output[-1])".Trim() } else { '' }
  if ($exitCode -ne 0 -or -not $version) { Fail-TraeSkin 'Trae embedded Node mode could not be started.' }
  try { $parsed = [version]$version } catch { Fail-TraeSkin "Invalid embedded Node version: $version" }
  if ($parsed.Major -lt 20 -or ($parsed.Major -eq 20 -and $parsed.Minor -lt 10)) {
    Fail-TraeSkin "Trae embedded Node 20.10 or newer is required; found $version."
  }
  $prefix = @()
  if ($parsed.Major -eq 20) { $prefix += '--experimental-websocket' }
  $probe = @(Invoke-TraeSkinNode -Trae $Trae -NodeArguments ($prefix + @('-p', 'typeof WebSocket')) 2>$null)
  if ($Script:TraeSkinLastNodeExitCode -ne 0 -or $probe.Count -eq 0 -or "$($probe[-1])".Trim() -ne 'function') {
    Fail-TraeSkin 'Trae embedded Node mode does not expose the WebSocket API required by the injector.'
  }
  return [pscustomobject]@{ Path = $Trae.Executable; Version = $version; PrefixArguments = $prefix }
}

function Start-TraeSkinNodeProcess {
  param(
    [Parameter(Mandatory = $true)][object]$Trae,
    [Parameter(Mandatory = $true)][object]$Runtime,
    [Parameter(Mandatory = $true)][string[]]$NodeArguments,
    [Parameter(Mandatory = $true)][string]$StandardOutput,
    [Parameter(Mandatory = $true)][string]$StandardError
  )
  $savedElectronMode = [Environment]::GetEnvironmentVariable('ELECTRON_RUN_AS_NODE', 'Process')
  $savedNodeOptions = [Environment]::GetEnvironmentVariable('NODE_OPTIONS', 'Process')
  $savedNodeRepl = [Environment]::GetEnvironmentVariable('NODE_REPL_EXTERNAL_MODULE', 'Process')
  try {
    $env:ELECTRON_RUN_AS_NODE = '1'
    Remove-Item Env:NODE_OPTIONS -ErrorAction SilentlyContinue
    Remove-Item Env:NODE_REPL_EXTERNAL_MODULE -ErrorAction SilentlyContinue
    $arguments = @($Runtime.PrefixArguments) + $NodeArguments
    $quoted = @($arguments | ForEach-Object { ConvertTo-TraeSkinProcessArgument -Value "$_" })
    return Start-Process -FilePath $Trae.Executable -ArgumentList $quoted -WindowStyle Hidden -PassThru `
      -RedirectStandardOutput $StandardOutput -RedirectStandardError $StandardError
  } finally {
    if ($null -eq $savedElectronMode) { Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue } else { $env:ELECTRON_RUN_AS_NODE = $savedElectronMode }
    if ($null -eq $savedNodeOptions) { Remove-Item Env:NODE_OPTIONS -ErrorAction SilentlyContinue } else { $env:NODE_OPTIONS = $savedNodeOptions }
    if ($null -eq $savedNodeRepl) { Remove-Item Env:NODE_REPL_EXTERNAL_MODULE -ErrorAction SilentlyContinue } else { $env:NODE_REPL_EXTERNAL_MODULE = $savedNodeRepl }
  }
}

function Get-TraeSkinProcessStartedAt {
  param([Parameter(Mandatory = $true)][int]$ProcessId)
  try { return (Get-Process -Id $ProcessId -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o') } catch { return $null }
}

function Test-TraeSkinApplicationProcessIdentity {
  param(
    [Parameter(Mandatory = $true)][object]$Trae,
    [Parameter(Mandatory = $true)][int]$ProcessId,
    [Parameter(Mandatory = $true)][string]$StartedAt
  )
  if ($ProcessId -le 0 -or -not $StartedAt) { return $false }
  $process = Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction SilentlyContinue
  if (-not $process) { return $false }
  $path = Get-TraeSkinProcessExecutablePath -ProcessInfo $process
  if (-not $path -or -not (Test-TraeSkinPathEqual -Left $path -Right $Trae.Executable)) { return $false }
  $currentStartedAt = Get-TraeSkinProcessStartedAt -ProcessId $ProcessId
  return [bool]($currentStartedAt -and $currentStartedAt -eq $StartedAt)
}

function Get-TraeSkinAllProcesses {
  param([Parameter(Mandatory = $true)][object]$Trae)
  $name = [System.IO.Path]::GetFileName($Trae.Executable).Replace("'", "''")
  return @(Get-CimInstance Win32_Process -Filter "Name = '$name'" -ErrorAction SilentlyContinue |
    Where-Object {
      $path = Get-TraeSkinProcessExecutablePath -ProcessInfo $_
      Test-TraeSkinPathEqual -Left $path -Right $Trae.Executable
    })
}

function Get-TraeSkinLaunchIntentProcesses {
  param(
    [AllowNull()][object]$State,
    [Parameter(Mandatory = $true)][object]$Trae
  )
  if ($null -eq $State -or "$($State.session)" -ne 'starting' -or
    -not (Test-TraeSkinLaunchToken -Value "$($State.launchToken)") -or
    -not (Test-TraeSkinPathEqual -Left $Trae.Executable -Right "$($State.traeExe)") -or
    $Trae.PublisherThumbprint -ine "$($State.traePublisherThumbprint)" -or
    $Trae.PublisherSubject -ine "$($State.traePublisherSubject)") { return @() }

  $launchTokenArgument = "--trae-dream-skin-launch-token=$($State.launchToken)"
  $portArgument = "--remote-debugging-port=$($State.port)"
  $matches = @()
  foreach ($process in Get-TraeSkinAllProcesses -Trae $Trae) {
    $commandLine = "$($process.CommandLine)"
    if ($commandLine -match '(?i)(?:^|[\s"])--type(?:=|\s)') { continue }
    if (-not (Test-TraeSkinCommandLineToken -CommandLine $commandLine -Token $launchTokenArgument) -or
      -not (Test-TraeSkinCommandLineToken -CommandLine $commandLine -Token '--remote-debugging-address=127.0.0.1') -or
      -not (Test-TraeSkinCommandLineToken -CommandLine $commandLine -Token $portArgument)) { continue }
    $processId = [int]$process.ProcessId
    $startedAt = Get-TraeSkinProcessStartedAt -ProcessId $processId
    if (-not $startedAt -or
      -not (Test-TraeSkinApplicationProcessIdentity -Trae $Trae -ProcessId $processId -StartedAt $startedAt)) {
      continue
    }
    $matches += [pscustomobject]@{ ProcessId = $processId; StartedAt = $startedAt }
  }
  return @($matches)
}

function Get-TraeSkinOrphanLaunchArguments {
  param([Parameter(Mandatory = $true)][object]$ProcessInfo)
  $commandLine = "$($ProcessInfo.CommandLine)"
  if (-not $commandLine -or $commandLine -match '(?i)(?:^|[\s"])--type(?:=|\s)') { return $null }

  $tokenPrefixPattern = '(?i)(?:^|[\s"])--trae-dream-skin-launch-token='
  $tokenPattern = '(?i)(?:^|[\s"])--trae-dream-skin-launch-token=(?<token>[a-f0-9]{32})(?=$|[\s"])'
  $tokenPrefixes = [regex]::Matches($commandLine, $tokenPrefixPattern)
  if ($tokenPrefixes.Count -eq 0) { return $null }
  $tokenMatches = [regex]::Matches($commandLine, $tokenPattern)

  $portPrefixPattern = '(?i)(?:^|[\s"])--remote-debugging-port='
  $portPattern = '(?i)(?:^|[\s"])--remote-debugging-port=(?<port>\d{1,5})(?=$|[\s"])'
  $portPrefixes = [regex]::Matches($commandLine, $portPrefixPattern)
  $portMatches = [regex]::Matches($commandLine, $portPattern)
  $port = 0
  $portText = if ($portMatches.Count -eq 1) { $portMatches[0].Groups['port'].Value } else { '' }
  $portParsed = [int]::TryParse($portText, [ref]$port)
  $valid = $tokenPrefixes.Count -eq 1 -and $tokenMatches.Count -eq 1 -and
    $portPrefixes.Count -eq 1 -and $portMatches.Count -eq 1 -and
    $portParsed -and $port -ge 1024 -and $port -le 65535 -and
    (Test-TraeSkinCommandLineToken -CommandLine $commandLine -Token '--remote-debugging-address=127.0.0.1')

  return [pscustomobject]@{
    Valid = [bool]$valid
    LaunchToken = if ($tokenMatches.Count -eq 1) { $tokenMatches[0].Groups['token'].Value.ToLowerInvariant() } else { $null }
    Port = if ($valid) { $port } else { $null }
  }
}

function Get-TraeSkinOrphanWatcherArguments {
  param([Parameter(Mandatory = $true)][object]$ProcessInfo)
  $commandLine = "$($ProcessInfo.CommandLine)"
  if (-not $commandLine -or $commandLine -match '(?i)(?:^|[\s"])--type(?:=|\s)') { return $null }

  $ownerPrefixPattern = '(?i)(?:^|[\s"])--owner-token(?:=|\s+)'
  $ownerPattern = '(?i)(?:^|[\s"])--owner-token(?:=|\s+)"?(?<token>[a-f0-9]{32})(?=$|[\s"])'
  $ownerPrefixes = [regex]::Matches($commandLine, $ownerPrefixPattern)
  if ($ownerPrefixes.Count -eq 0) { return $null }
  $ownerMatches = [regex]::Matches($commandLine, $ownerPattern)

  $portPrefixPattern = '(?i)(?:^|[\s"])--port(?:=|\s+)'
  $portPattern = '(?i)(?:^|[\s"])--port(?:=|\s+)"?(?<port>\d{1,5})(?=$|[\s"])'
  $portPrefixes = [regex]::Matches($commandLine, $portPrefixPattern)
  $portMatches = [regex]::Matches($commandLine, $portPattern)
  $browserPrefixPattern = '(?i)(?:^|[\s"])--browser-id(?:=|\s+)'
  $browserPattern = '(?i)(?:^|[\s"])--browser-id(?:=|\s+)"?(?<browser>[A-Za-z0-9._-]{1,200})(?=$|[\s"])'
  $browserPrefixes = [regex]::Matches($commandLine, $browserPrefixPattern)
  $browserMatches = [regex]::Matches($commandLine, $browserPattern)
  $watchMatches = [regex]::Matches($commandLine, '(?i)(?:^|[\s"])--watch(?=$|[\s"])')
  $port = 0
  $portText = if ($portMatches.Count -eq 1) { $portMatches[0].Groups['port'].Value } else { '' }
  $portParsed = [int]::TryParse($portText, [ref]$port)
  $valid = $ownerPrefixes.Count -eq 1 -and $ownerMatches.Count -eq 1 -and
    $portPrefixes.Count -eq 1 -and $portMatches.Count -eq 1 -and
    $browserPrefixes.Count -eq 1 -and $browserMatches.Count -eq 1 -and
    $watchMatches.Count -eq 1 -and $portParsed -and $port -ge 1024 -and $port -le 65535
  return [pscustomobject]@{
    Valid = [bool]$valid
    LaunchToken = if ($ownerMatches.Count -eq 1) { $ownerMatches[0].Groups['token'].Value.ToLowerInvariant() } else { $null }
    Port = if ($valid) { $port } else { $null }
    BrowserId = if ($browserMatches.Count -eq 1) { $browserMatches[0].Groups['browser'].Value } else { $null }
  }
}

function Get-TraeSkinStandaloneOrphanWatcherScan {
  param([AllowEmptyCollection()][string[]]$ExcludedTokens = @())
  $verified = @()
  $unverified = @()
  $seenProcessIds = [System.Collections.Generic.HashSet[int]]::new()
  foreach ($nameValue in $Script:TraeSkinExecutableNames) {
    $name = $nameValue.Replace("'", "''")
    foreach ($process in Get-CimInstance Win32_Process -Filter "Name = '$name'" -ErrorAction SilentlyContinue) {
      $processId = [int]$process.ProcessId
      if (-not $seenProcessIds.Add($processId)) { continue }
      $arguments = Get-TraeSkinOrphanWatcherArguments -ProcessInfo $process
      if ($null -eq $arguments) { continue }
      if (-not $arguments.Valid) {
        $unverified += [pscustomobject]@{ ProcessId = $processId; Reason = 'malformed dedicated watcher arguments' }
        continue
      }
      if ($ExcludedTokens -icontains "$($arguments.LaunchToken)") { continue }

      $path = Get-TraeSkinProcessExecutablePath -ProcessInfo $process
      $trae = if ($path) { ConvertTo-TraeSkinInstall -Executable $path } else { $null }
      $startedAt = Get-TraeSkinProcessStartedAt -ProcessId $processId
      if ($null -eq $trae -or -not $startedAt -or
        -not (Test-TraeSkinApplicationProcessIdentity -Trae $trae -ProcessId $processId -StartedAt $startedAt)) {
        if (Get-Process -Id $processId -ErrorAction SilentlyContinue) {
          $unverified += [pscustomobject]@{ ProcessId = $processId; Reason = 'watcher publisher or process identity was not verifiable' }
        }
        continue
      }
      $confirmedProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $processId" -ErrorAction SilentlyContinue
      $confirmedArguments = if ($confirmedProcess) {
        Get-TraeSkinOrphanWatcherArguments -ProcessInfo $confirmedProcess
      } else {
        $null
      }
      if ($null -eq $confirmedArguments) { continue }
      if (-not $confirmedArguments.Valid -or
        "$($confirmedArguments.LaunchToken)" -cne "$($arguments.LaunchToken)" -or
        [int]$confirmedArguments.Port -ne [int]$arguments.Port -or
        "$($confirmedArguments.BrowserId)" -cne "$($arguments.BrowserId)" -or
        (Get-TraeSkinProcessStartedAt -ProcessId $processId) -ne $startedAt) {
        $unverified += [pscustomobject]@{ ProcessId = $processId; Reason = 'watcher identity changed during orphan discovery' }
        continue
      }
      if (-not (Test-TraeSkinPortAvailable -Port ([int]$arguments.Port))) {
        $unverified += [pscustomobject]@{ ProcessId = $processId; Reason = 'standalone watcher port is still active' }
        continue
      }
      $verified += [pscustomobject]@{
        Trae = $trae
        ProcessId = 0
        StartedAt = $null
        WatcherProcessId = $processId
        WatcherStartedAt = $startedAt
        Port = [int]$arguments.Port
        LaunchToken = "$($arguments.LaunchToken)"
        BrowserId = "$($arguments.BrowserId)"
      }
    }
  }

  $watchers = @()
  foreach ($group in @($verified | Group-Object LaunchToken)) {
    if ($group.Count -eq 1) {
      $watchers += $group.Group[0]
    } else {
      foreach ($item in $group.Group) {
        $unverified += [pscustomobject]@{ ProcessId = $item.WatcherProcessId; Reason = 'duplicate dedicated watcher token' }
      }
    }
  }
  return [pscustomobject]@{ Watchers = @($watchers); Unverified = @($unverified) }
}

function Get-TraeSkinOrphanSessionScan {
  $verified = @()
  $unverified = @()
  $observedTokens = @()
  $seenProcessIds = [System.Collections.Generic.HashSet[int]]::new()
  foreach ($nameValue in $Script:TraeSkinExecutableNames) {
    $name = $nameValue.Replace("'", "''")
    foreach ($process in Get-CimInstance Win32_Process -Filter "Name = '$name'" -ErrorAction SilentlyContinue) {
      $processId = [int]$process.ProcessId
      if (-not $seenProcessIds.Add($processId)) { continue }
      $arguments = Get-TraeSkinOrphanLaunchArguments -ProcessInfo $process
      if ($null -eq $arguments) { continue }
      if (-not $arguments.Valid) {
        $unverified += [pscustomobject]@{ ProcessId = $processId; Reason = 'malformed dedicated launch arguments' }
        continue
      }

      $path = Get-TraeSkinProcessExecutablePath -ProcessInfo $process
      $trae = if ($path) { ConvertTo-TraeSkinInstall -Executable $path } else { $null }
      $startedAt = Get-TraeSkinProcessStartedAt -ProcessId $processId
      if ($null -eq $trae -or -not $startedAt -or
        -not (Test-TraeSkinApplicationProcessIdentity -Trae $trae -ProcessId $processId -StartedAt $startedAt)) {
        if (Get-Process -Id $processId -ErrorAction SilentlyContinue) {
          $unverified += [pscustomobject]@{ ProcessId = $processId; Reason = 'publisher or process identity was not verifiable' }
        }
        continue
      }
      $confirmedProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $processId" -ErrorAction SilentlyContinue
      $confirmedArguments = if ($confirmedProcess) {
        Get-TraeSkinOrphanLaunchArguments -ProcessInfo $confirmedProcess
      } else {
        $null
      }
      if ($null -eq $confirmedArguments) { continue }
      if (-not $confirmedArguments.Valid -or
        "$($confirmedArguments.LaunchToken)" -cne "$($arguments.LaunchToken)" -or
        [int]$confirmedArguments.Port -ne [int]$arguments.Port -or
        (Get-TraeSkinProcessStartedAt -ProcessId $processId) -ne $startedAt) {
        $unverified += [pscustomobject]@{ ProcessId = $processId; Reason = 'process identity changed during orphan discovery' }
        continue
      }
      $observedTokens += "$($arguments.LaunchToken)"

      $portOwned = $false
      $portConflict = $false
      $browserId = $null
      if (-not (Test-TraeSkinPortAvailable -Port ([int]$arguments.Port))) {
        $owner = Get-TraeSkinPortOwnerIdentity -Port ([int]$arguments.Port) -Trae $trae
        $portOwned = $null -ne $owner -and [int]$owner.ProcessId -eq $processId -and
          "$($owner.StartedAt)" -eq $startedAt
        $portConflict = -not $portOwned
        if ($portOwned) {
          $browser = Get-TraeSkinCdpBrowserIdentity -Port ([int]$arguments.Port)
          if ($null -ne $browser) { $browserId = $browser.BrowserId }
        }
      }
      if ($portConflict) {
        $unverified += [pscustomobject]@{ ProcessId = $processId; Reason = 'debugging port belongs to another process' }
        continue
      }
      $verified += [pscustomobject]@{
        Trae = $trae
        ProcessId = $processId
        StartedAt = $startedAt
        Port = [int]$arguments.Port
        LaunchToken = "$($arguments.LaunchToken)"
        PortOwned = [bool]$portOwned
        PortConflict = [bool]$portConflict
        BrowserId = $browserId
      }
    }
  }

  $sessions = @()
  foreach ($group in @($verified | Group-Object LaunchToken)) {
    if ($group.Count -eq 1) {
      $sessions += $group.Group[0]
    } else {
      foreach ($item in $group.Group) {
        $unverified += [pscustomobject]@{ ProcessId = $item.ProcessId; Reason = 'duplicate dedicated launch token' }
      }
    }
  }
  $standaloneWatcherScan = Get-TraeSkinStandaloneOrphanWatcherScan -ExcludedTokens @($observedTokens)
  $unverified += @($standaloneWatcherScan.Unverified)
  return [pscustomobject]@{
    Sessions = @($sessions)
    StandaloneWatchers = @($standaloneWatcherScan.Watchers)
    Unverified = @($unverified)
  }
}

function Test-TraeSkinOrphanApplicationIdentity {
  param([Parameter(Mandatory = $true)][object]$Session)
  if (-not (Test-TraeSkinApplicationProcessIdentity -Trae $Session.Trae `
    -ProcessId ([int]$Session.ProcessId) -StartedAt "$($Session.StartedAt)")) { return $false }
  $process = Get-CimInstance Win32_Process -Filter "ProcessId = $([int]$Session.ProcessId)" -ErrorAction SilentlyContinue
  if (-not $process) { return $false }
  $arguments = Get-TraeSkinOrphanLaunchArguments -ProcessInfo $process
  return [bool]($null -ne $arguments -and $arguments.Valid -and
    "$($arguments.LaunchToken)" -ceq "$($Session.LaunchToken)" -and
    [int]$arguments.Port -eq [int]$Session.Port)
}

function Test-TraeSkinInjectorProcessInfo {
  param([Parameter(Mandatory = $true)][object]$ProcessInfo)
  $commandLine = "$($ProcessInfo.CommandLine)"
  return (Test-TraeSkinCommandLineToken -CommandLine $commandLine -Token $Script:TraeSkinInjector) -and
    (Test-TraeSkinCommandLineToken -CommandLine $commandLine -Token '--watch')
}

function Get-TraeSkinApplicationProcesses {
  param([Parameter(Mandatory = $true)][object]$Trae)
  return @(Get-TraeSkinAllProcesses -Trae $Trae | Where-Object { -not (Test-TraeSkinInjectorProcessInfo -ProcessInfo $_) })
}

function Stop-TraeSkinApplication {
  param([Parameter(Mandatory = $true)][object]$Trae, [switch]$AllowForce)
  $processes = Get-TraeSkinApplicationProcesses -Trae $Trae
  if ($processes.Count -eq 0) { return }
  foreach ($item in $processes) {
    try { [void](Get-Process -Id ([int]$item.ProcessId) -ErrorAction Stop).CloseMainWindow() } catch {}
  }
  $deadline = (Get-Date).AddSeconds(15)
  while ((Get-TraeSkinApplicationProcesses -Trae $Trae).Count -gt 0 -and (Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 250
  }
  $remaining = Get-TraeSkinApplicationProcesses -Trae $Trae
  if ($remaining.Count -eq 0) { return }
  if (-not $AllowForce) { Fail-TraeSkin 'Trae did not close within 15 seconds.' }
  foreach ($item in $remaining) {
    $current = Get-CimInstance Win32_Process -Filter "ProcessId = $([int]$item.ProcessId)" -ErrorAction SilentlyContinue
    $path = if ($current) { Get-TraeSkinProcessExecutablePath -ProcessInfo $current } else { $null }
    if ($path -and (Test-TraeSkinPathEqual -Left $path -Right $Trae.Executable) -and
      -not (Test-TraeSkinInjectorProcessInfo -ProcessInfo $current)) {
      Stop-Process -Id ([int]$item.ProcessId) -Force -ErrorAction SilentlyContinue
    }
  }
  Start-Sleep -Milliseconds 600
  if ((Get-TraeSkinApplicationProcesses -Trae $Trae).Count -gt 0) { Fail-TraeSkin 'Trae could not be stopped safely.' }
}

function Stop-TraeSkinRecordedApplication {
  param(
    [Parameter(Mandatory = $true)][object]$Trae,
    [Parameter(Mandatory = $true)][int]$ProcessId,
    [Parameter(Mandatory = $true)][string]$StartedAt,
    [switch]$AllowForce
  )
  if (-not (Test-TraeSkinApplicationProcessIdentity -Trae $Trae -ProcessId $ProcessId -StartedAt $StartedAt)) {
    if (-not (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue)) { return }
    Fail-TraeSkin "Recorded Trae PID $ProcessId no longer matches its saved executable and start time."
  }

  try { $process = Get-Process -Id $ProcessId -ErrorAction Stop } catch { return }
  try {
    $stableHandle = $process.SafeHandle
    if ($stableHandle.IsInvalid -or $stableHandle.IsClosed -or $process.HasExited) { return }
    $objectStartedAt = $process.StartTime.ToUniversalTime().ToString('o')
    $objectPath = $null
    try { $objectPath = "$($process.Path)" } catch {
      try { $objectPath = "$($process.MainModule.FileName)" } catch {}
    }
    if ($objectStartedAt -ne $StartedAt -or
      -not (Test-TraeSkinPathEqual -Left $objectPath -Right $Trae.Executable)) {
      Fail-TraeSkin "Recorded Trae PID $ProcessId changed before it could be closed."
    }

    try { [void]$process.CloseMainWindow() } catch {}
    if ($process.WaitForExit(15000)) { return }
    if (-not $AllowForce) { Fail-TraeSkin 'The recorded Trae skin process did not close within 15 seconds.' }
    if ($process.HasExited) { return }
    $process.Kill()
    if (-not $process.WaitForExit(5000)) {
      Fail-TraeSkin 'The recorded Trae skin process could not be stopped safely.'
    }
  } catch {
    if (Test-TraeSkinApplicationProcessIdentity -Trae $Trae -ProcessId $ProcessId -StartedAt $StartedAt) {
      Fail-TraeSkin 'The exact recorded Trae process could not be closed through its stable process handle.'
    }
    return
  } finally {
    if ($null -ne $process) { $process.Dispose() }
  }
}

function Test-TraeSkinBrowserId {
  param([string]$Value)
  return [bool]($Value -and $Value.Length -le 200 -and $Value -cmatch '^[A-Za-z0-9._-]+$')
}

function Test-TraeSkinLaunchToken {
  param([string]$Value)
  return [bool]($Value -and $Value -cmatch '^[a-fA-F0-9]{32}$')
}

function Test-TraeSkinWebSocketUrl {
  param([string]$Value, [int]$Port, [ValidateSet('page', 'browser')][string]$Kind)
  try {
    $uri = [Uri]$Value
    $hostName = $uri.Host.ToLowerInvariant()
    if (-not $uri.IsAbsoluteUri -or $uri.Scheme -ne 'ws' -or $uri.Port -ne $Port -or
      $hostName -notin @('127.0.0.1', 'localhost', '::1', '[::1]') -or $uri.UserInfo -or
      $uri.Query -or $uri.Fragment) { return $false }
    return $uri.AbsolutePath -cmatch "^/devtools/$Kind/[A-Za-z0-9._-]{1,200}$"
  } catch {
    return $false
  }
}

function Get-TraeSkinPortListeners {
  param([int]$Port)
  if (-not (Get-Command Get-NetTCPConnection -ErrorAction SilentlyContinue)) {
    Fail-TraeSkin 'Get-NetTCPConnection is required to verify CDP listener ownership.'
  }
  return @(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue)
}

function Test-TraeSkinLoopbackAddress {
  param([string]$Value)
  if (-not $Value) { return $false }
  try {
    $address = [System.Net.IPAddress]::Parse($Value.Trim([char[]]'[]'))
    return [System.Net.IPAddress]::IsLoopback($address)
  } catch {
    return $false
  }
}

function Test-TraeSkinPortAvailable {
  param([int]$Port)
  return (Get-TraeSkinPortListeners -Port $Port).Count -eq 0
}

function Get-TraeSkinPortOwnerIdentity {
  param([int]$Port, [Parameter(Mandatory = $true)][object]$Trae)
  if ($null -eq (Get-TraeSkinAuthenticodeIdentity -Executable $Trae.Executable)) { return $null }
  $listeners = Get-TraeSkinPortListeners -Port $Port
  if ($listeners.Count -eq 0) { return $null }
  $ownerProcessId = 0
  foreach ($listener in $listeners) {
    if (-not (Test-TraeSkinLoopbackAddress -Value "$($listener.LocalAddress)")) { return $null }
    $listenerProcessId = [int]$listener.OwningProcess
    if ($listenerProcessId -le 0) { return $null }
    if ($ownerProcessId -eq 0) { $ownerProcessId = $listenerProcessId }
    if ($ownerProcessId -ne $listenerProcessId) { return $null }
    $process = Get-CimInstance Win32_Process -Filter "ProcessId = $listenerProcessId" -ErrorAction SilentlyContinue
    $path = if ($process) { Get-TraeSkinProcessExecutablePath -ProcessInfo $process } else { $null }
    if (-not $path -or -not (Test-TraeSkinPathEqual -Left $path -Right $Trae.Executable)) { return $null }
  }
  $startedAt = Get-TraeSkinProcessStartedAt -ProcessId $ownerProcessId
  if (-not $startedAt -or
    -not (Test-TraeSkinApplicationProcessIdentity -Trae $Trae -ProcessId $ownerProcessId -StartedAt $startedAt)) {
    return $null
  }
  return [pscustomobject]@{ ProcessId = $ownerProcessId; StartedAt = $startedAt }
}

function Test-TraeSkinPortOwner {
  param([int]$Port, [Parameter(Mandatory = $true)][object]$Trae)
  return $null -ne (Get-TraeSkinPortOwnerIdentity -Port $Port -Trae $Trae)
}

function Get-TraeSkinCdpBrowserIdentity {
  param([int]$Port)
  try {
    $version = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/json/version" -TimeoutSec 2 `
      -MaximumRedirection 0 -ErrorAction Stop
    $url = "$($version.webSocketDebuggerUrl)"
    if (-not (Test-TraeSkinWebSocketUrl -Value $url -Port $Port -Kind browser)) { return $null }
    $match = [regex]::Match(([Uri]$url).AbsolutePath, '^/devtools/browser/(?<id>[A-Za-z0-9._-]{1,200})$')
    if (-not $match.Success) { return $null }
    return [pscustomobject]@{
      BrowserId = $match.Groups['id'].Value
      Browser = "$($version.Browser)"
      WebSocketDebuggerUrl = $url
    }
  } catch {
    return $null
  }
}

function Get-TraeSkinCdpTargets {
  param([int]$Port)
  try {
    $items = @(Invoke-RestMethod -Uri "http://127.0.0.1:$Port/json/list" -TimeoutSec 2 `
      -MaximumRedirection 0 -ErrorAction Stop)
    $targets = @()
    foreach ($item in $items) {
      $id = "$($item.id)"
      $url = "$($item.webSocketDebuggerUrl)"
      if ("$($item.type)" -cne 'page' -or -not (Test-TraeSkinBrowserId -Value $id) -or
        -not (Test-TraeSkinWebSocketUrl -Value $url -Port $Port -Kind page)) { continue }
      if (([Uri]$url).AbsolutePath -cne "/devtools/page/$id") { continue }
      $targets += $item
    }
    return $targets
  } catch {
    return @()
  }
}

function Get-TraeSkinVerifiedCdpIdentity {
  param([int]$Port, [Parameter(Mandatory = $true)][object]$Trae)
  $owner = Get-TraeSkinPortOwnerIdentity -Port $Port -Trae $Trae
  if ($null -eq $owner) { return $null }
  $browser = Get-TraeSkinCdpBrowserIdentity -Port $Port
  if ($null -eq $browser) { return $null }
  $targets = Get-TraeSkinCdpTargets -Port $Port
  if ($targets.Count -eq 0) { return $null }
  $confirmedOwner = Get-TraeSkinPortOwnerIdentity -Port $Port -Trae $Trae
  if ($null -eq $confirmedOwner -or $confirmedOwner.ProcessId -ne $owner.ProcessId -or
    $confirmedOwner.StartedAt -ne $owner.StartedAt) { return $null }
  return [pscustomobject]@{
    BrowserId = $browser.BrowserId
    Browser = $browser.Browser
    TargetCount = $targets.Count
    OwnerProcessId = $owner.ProcessId
    OwnerStartedAt = $owner.StartedAt
  }
}

function Test-TraeSkinCdpIdentityMatchesState {
  param([AllowNull()][object]$Identity, [AllowNull()][object]$State)
  if ($null -eq $Identity -or $null -eq $State -or -not $State.ownsSession) { return $false }
  if ([int]$Identity.OwnerProcessId -ne [int]$State.traePid -or
    $Identity.OwnerStartedAt -ne "$($State.traeStartedAt)") { return $false }
  if ($State.browserId) { return $Identity.BrowserId -ceq "$($State.browserId)" }
  return "$($State.session)" -eq 'starting'
}

function Select-TraeSkinPort {
  param([int]$PreferredPort)
  for ($candidate = $PreferredPort; $candidate -le [Math]::Min(65535, $PreferredPort + 100); $candidate++) {
    if (Test-TraeSkinPortAvailable -Port $candidate) { return $candidate }
  }
  Fail-TraeSkin 'No free loopback port was found in the preferred range.'
}

function Wait-TraeSkinPortAvailable {
  param([int]$Port, [int]$TimeoutSeconds = 6)
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  do {
    if (Test-TraeSkinPortAvailable -Port $Port) { return $true }
    Start-Sleep -Milliseconds 200
  } while ((Get-Date) -lt $deadline)
  return $false
}

function Wait-TraeSkinCdpIdentity {
  param([int]$Port, [Parameter(Mandatory = $true)][object]$Trae, [int]$TimeoutSeconds = 45)
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  do {
    $identity = Get-TraeSkinVerifiedCdpIdentity -Port $Port -Trae $Trae
    if ($null -ne $identity) { return $identity }
    Start-Sleep -Milliseconds 400
  } while ((Get-Date) -lt $deadline)
  return $null
}

function Test-TraeSkinInjectorProcessIdentity {
  param(
    [Parameter(Mandatory = $true)][object]$State,
    [Parameter(Mandatory = $true)][int]$ProcessId,
    [AllowNull()][string]$ExpectedStartedAt
  )
  if ($ProcessId -le 0 -or -not $State.runtimePath -or -not $State.injectorPath -or
    -not $State.themeDir) { return $false }
  $process = Get-CimInstance Win32_Process -Filter "ProcessId = $processId" -ErrorAction SilentlyContinue
  if (-not $process) { return $false }
  $path = Get-TraeSkinProcessExecutablePath -ProcessInfo $process
  if (-not (Test-TraeSkinPathEqual -Left $path -Right "$($State.runtimePath)")) { return $false }
  $signature = Get-TraeSkinAuthenticodeIdentity -Executable $path
  if ($null -eq $signature -or
    $signature.Thumbprint -ine "$($State.traePublisherThumbprint)" -or
    $signature.Subject -ine "$($State.traePublisherSubject)") { return $false }
  $commandLine = "$($process.CommandLine)"
  if (-not (Test-TraeSkinCommandLineToken -CommandLine $commandLine -Token "$($State.injectorPath)") -or
    -not (Test-TraeSkinCommandLineToken -CommandLine $commandLine -Token '--watch') -or
    -not (Test-TraeSkinCommandLineToken -CommandLine $commandLine -Token '--theme-dir')) { return $false }
  if (-not (Test-TraeSkinCommandLineToken -CommandLine $commandLine -Token "$($State.themeDir)")) { return $false }
  $portPattern = '(?i)(?:^|\s)--port(?:=|\s+)' + [regex]::Escape("$($State.port)") + '(?=$|\s)'
  if (-not [regex]::IsMatch($commandLine, $portPattern)) { return $false }
  if ($State.browserId) {
    $browserPattern = '(?i)(?:^|\s)--browser-id(?:=|\s+)' + [regex]::Escape("$($State.browserId)") + '(?=$|\s)'
    if (-not [regex]::IsMatch($commandLine, $browserPattern)) { return $false }
  }
  if (Test-TraeSkinLaunchToken -Value "$($State.launchToken)") {
    if (-not (Test-TraeSkinCommandLineOptionValue -CommandLine $commandLine `
      -Option '--owner-token' -Value "$($State.launchToken)")) { return $false }
  }
  $startedAt = Get-TraeSkinProcessStartedAt -ProcessId $ProcessId
  if (-not $startedAt) { return $false }
  return [bool](-not $ExpectedStartedAt -or $startedAt -eq $ExpectedStartedAt)
}

function Test-TraeSkinOrphanWatcherProcessIdentity {
  param(
    [Parameter(Mandatory = $true)][object]$Session,
    [Parameter(Mandatory = $true)][int]$ProcessId,
    [Parameter(Mandatory = $true)][string]$StartedAt
  )
  if (-not (Test-TraeSkinLaunchToken -Value "$($Session.LaunchToken)") -or
    -not (Test-TraeSkinApplicationProcessIdentity -Trae $Session.Trae `
      -ProcessId $ProcessId -StartedAt $StartedAt)) { return $false }
  $process = Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction SilentlyContinue
  if (-not $process) { return $false }
  $commandLine = "$($process.CommandLine)"
  if ($commandLine -match '(?i)(?:^|[\s"])--type(?:=|\s)' -or
    -not (Test-TraeSkinCommandLineToken -CommandLine $commandLine -Token '--watch') -or
    -not (Test-TraeSkinCommandLineOptionValue -CommandLine $commandLine `
      -Option '--owner-token' -Value "$($Session.LaunchToken)") -or
    -not (Test-TraeSkinCommandLineOptionValue -CommandLine $commandLine `
      -Option '--port' -Value "$($Session.Port)")) { return $false }
  if ($Session.BrowserId -and -not (Test-TraeSkinCommandLineOptionValue -CommandLine $commandLine `
    -Option '--browser-id' -Value "$($Session.BrowserId)")) { return $false }
  return $true
}

function Get-TraeSkinOrphanWatcherProcesses {
  param([Parameter(Mandatory = $true)][object]$Session)
  $matches = @()
  foreach ($process in Get-TraeSkinAllProcesses -Trae $Session.Trae) {
    $processId = [int]$process.ProcessId
    if ($processId -eq [int]$Session.ProcessId) { continue }
    $startedAt = Get-TraeSkinProcessStartedAt -ProcessId $processId
    if ($startedAt -and (Test-TraeSkinOrphanWatcherProcessIdentity -Session $Session `
      -ProcessId $processId -StartedAt $startedAt)) {
      $matches += [pscustomobject]@{ ProcessId = $processId; StartedAt = $startedAt }
    }
  }
  return @($matches)
}

function Stop-TraeSkinOrphanWatchers {
  param([Parameter(Mandatory = $true)][object]$Session)
  $allStopped = $true
  foreach ($candidate in @(Get-TraeSkinOrphanWatcherProcesses -Session $Session)) {
    $process = $null
    try { $process = Get-Process -Id ([int]$candidate.ProcessId) -ErrorAction Stop } catch { continue }
    try {
      $stableHandle = $process.SafeHandle
      if ($stableHandle.IsInvalid -or $stableHandle.IsClosed -or $process.HasExited) { continue }
      $objectStartedAt = $process.StartTime.ToUniversalTime().ToString('o')
      if ($objectStartedAt -ne "$($candidate.StartedAt)" -or
        -not (Test-TraeSkinOrphanWatcherProcessIdentity -Session $Session `
          -ProcessId ([int]$candidate.ProcessId) -StartedAt "$($candidate.StartedAt)")) { continue }
      $process.Kill()
      if (-not $process.WaitForExit(5000)) { throw 'Timed out.' }
    } catch {
      if (Test-TraeSkinOrphanWatcherProcessIdentity -Session $Session `
        -ProcessId ([int]$candidate.ProcessId) -StartedAt "$($candidate.StartedAt)") {
        $allStopped = $false
        Write-Warning "Orphan injector PID $($candidate.ProcessId) could not be stopped."
      }
    } finally {
      if ($null -ne $process) { $process.Dispose() }
    }
  }
  return [bool]($allStopped -and @(Get-TraeSkinOrphanWatcherProcesses -Session $Session).Count -eq 0)
}

function Get-TraeSkinOwnedInjectorProcesses {
  param([AllowNull()][object]$State)
  if ($null -eq $State -or -not $State.runtimePath) { return @() }
  $runtimeName = [System.IO.Path]::GetFileName("$($State.runtimePath)").Replace("'", "''")
  $recordedPid = 0
  if ($State.injectorPid) { [void][int]::TryParse("$($State.injectorPid)", [ref]$recordedPid) }
  $recordedStartedAt = "$($State.injectorStartedAt)"
  $matches = @()
  foreach ($process in Get-CimInstance Win32_Process -Filter "Name = '$runtimeName'" -ErrorAction SilentlyContinue) {
    $processId = [int]$process.ProcessId
    $startedAt = Get-TraeSkinProcessStartedAt -ProcessId $processId
    if (-not $startedAt) { continue }
    if ($processId -eq $recordedPid -and $recordedStartedAt -and $startedAt -ne $recordedStartedAt) {
      continue
    }
    if (Test-TraeSkinInjectorProcessIdentity -State $State -ProcessId $processId -ExpectedStartedAt $startedAt) {
      $matches += [pscustomobject]@{ ProcessId = $processId; StartedAt = $startedAt }
    }
  }
  return $matches
}

function Test-TraeSkinRecordedInjectorIdentity {
  param([AllowNull()][object]$State)
  if ($null -eq $State -or -not $State.injectorPid -or -not $State.injectorStartedAt) { return $false }
  return Test-TraeSkinInjectorProcessIdentity -State $State -ProcessId ([int]$State.injectorPid) `
    -ExpectedStartedAt "$($State.injectorStartedAt)"
}

function Stop-TraeSkinOwnedInjectors {
  param([AllowNull()][object]$State)
  if ($null -eq $State) { return $true }
  $allStopped = $true
  foreach ($candidate in @(Get-TraeSkinOwnedInjectorProcesses -State $State)) {
    $process = $null
    try { $process = Get-Process -Id ([int]$candidate.ProcessId) -ErrorAction Stop } catch { continue }
    try {
      $stableHandle = $process.SafeHandle
      if ($stableHandle.IsInvalid -or $stableHandle.IsClosed -or $process.HasExited) { continue }
      $objectStartedAt = $process.StartTime.ToUniversalTime().ToString('o')
      if ($objectStartedAt -ne "$($candidate.StartedAt)" -or
        -not (Test-TraeSkinInjectorProcessIdentity -State $State -ProcessId ([int]$candidate.ProcessId) `
          -ExpectedStartedAt "$($candidate.StartedAt)")) { continue }
      $process.Kill()
      if (-not $process.WaitForExit(5000)) { throw 'Timed out.' }
    } catch {
      if (Test-TraeSkinInjectorProcessIdentity -State $State -ProcessId ([int]$candidate.ProcessId) `
        -ExpectedStartedAt "$($candidate.StartedAt)") {
        $allStopped = $false
        Write-Warning "Owned injector PID $($candidate.ProcessId) could not be stopped."
      }
    } finally {
      if ($null -ne $process) { $process.Dispose() }
    }
    if (Test-TraeSkinInjectorProcessIdentity -State $State -ProcessId ([int]$candidate.ProcessId) `
      -ExpectedStartedAt "$($candidate.StartedAt)") { $allStopped = $false }
  }
  return [bool]($allStopped -and @(Get-TraeSkinOwnedInjectorProcesses -State $State).Count -eq 0)
}

function Stop-TraeSkinRecordedInjector {
  param([AllowNull()][object]$State)
  if (-not (Stop-TraeSkinOwnedInjectors -State $State)) {
    Fail-TraeSkin 'One or more confirmed owned injector processes did not stop.'
  }
  return $true
}

function Stop-TraeSkinOrphanSession {
  param([Parameter(Mandatory = $true)][object]$Session)
  if (-not (Stop-TraeSkinOrphanWatchers -Session $Session)) {
    Write-Warning 'A token-matched orphan injector did not stop yet; its exact Trae process will still be closed.'
  }

  $applicationIdentity = Test-TraeSkinApplicationProcessIdentity -Trae $Session.Trae `
    -ProcessId ([int]$Session.ProcessId) -StartedAt "$($Session.StartedAt)"
  if ($applicationIdentity -and -not (Test-TraeSkinOrphanApplicationIdentity -Session $Session)) {
    Fail-TraeSkin 'An orphan Trae process changed its dedicated launch arguments. It was not stopped.'
  }
  if ($applicationIdentity) {
    Stop-TraeSkinRecordedApplication -Trae $Session.Trae -ProcessId ([int]$Session.ProcessId) `
      -StartedAt "$($Session.StartedAt)" -AllowForce
  }
  if (Test-TraeSkinOrphanApplicationIdentity -Session $Session) {
    Fail-TraeSkin 'The exact token-matched orphan Trae process is still active.'
  }
  if (-not (Wait-TraeSkinPortAvailable -Port ([int]$Session.Port) -TimeoutSeconds 6)) {
    Fail-TraeSkin "Orphan port $($Session.Port) is still listening; no unrelated listener was stopped."
  }
  if (-not (Stop-TraeSkinOrphanWatchers -Session $Session)) {
    Fail-TraeSkin 'A token-matched orphan injector remained after its Trae process closed.'
  }
  return $true
}

function Start-TraeSkinApplicationProcess {
  param(
    [Parameter(Mandatory = $true)][object]$Trae,
    [AllowEmptyCollection()][string[]]$Arguments = @()
  )
  $savedElectronMode = [Environment]::GetEnvironmentVariable('ELECTRON_RUN_AS_NODE', 'Process')
  $savedNodeOptions = [Environment]::GetEnvironmentVariable('NODE_OPTIONS', 'Process')
  $savedNodeRepl = [Environment]::GetEnvironmentVariable('NODE_REPL_EXTERNAL_MODULE', 'Process')
  try {
    Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
    Remove-Item Env:NODE_OPTIONS -ErrorAction SilentlyContinue
    Remove-Item Env:NODE_REPL_EXTERNAL_MODULE -ErrorAction SilentlyContinue
    if ($Arguments.Count -gt 0) {
      $process = Start-Process -FilePath $Trae.Executable -ArgumentList $Arguments -PassThru
    } else {
      $process = Start-Process -FilePath $Trae.Executable -PassThru
    }
    return $process
  } finally {
    if ($null -eq $savedElectronMode) { Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue } else { $env:ELECTRON_RUN_AS_NODE = $savedElectronMode }
    if ($null -eq $savedNodeOptions) { Remove-Item Env:NODE_OPTIONS -ErrorAction SilentlyContinue } else { $env:NODE_OPTIONS = $savedNodeOptions }
    if ($null -eq $savedNodeRepl) { Remove-Item Env:NODE_REPL_EXTERNAL_MODULE -ErrorAction SilentlyContinue } else { $env:NODE_REPL_EXTERNAL_MODULE = $savedNodeRepl }
  }
}

function Start-TraeSkinNormally {
  param([Parameter(Mandatory = $true)][object]$Trae)
  $null = Start-TraeSkinApplicationProcess -Trae $Trae
}
