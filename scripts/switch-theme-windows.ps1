[CmdletBinding()]
param(
  [string]$Theme,
  [int]$Port = 9342,
  [switch]$RestartExisting
)

$ErrorActionPreference = 'Stop'
$PortExplicit = $PSBoundParameters.ContainsKey('Port')
. (Join-Path $PSScriptRoot 'common-windows.ps1')

Assert-TraeSkinWindows
$publicThemeIds = @(
  'neon-portal',
  'ember-glass',
  'paper-aurora',
  'sunlit-spark',
  'violet-rift'
)
$themes = @($publicThemeIds | ForEach-Object { Resolve-TraeSkinTheme -ThemeId $_ })

if (-not $Theme) {
  Write-Host 'Available Trae skins:'
  for ($index = 0; $index -lt $themes.Count; $index++) {
    Write-Host ("  {0}. {1}" -f ($index + 1), $themes[$index].Id)
  }
  $selection = (Read-Host 'Choose a number or enter a theme ID').Trim()
  if ($selection -match '^\d+$') {
    $number = [int]$selection
    if ($number -lt 1 -or $number -gt $themes.Count) { Fail-TraeSkin 'Theme selection is out of range.' }
    $Theme = $themes[$number - 1].Id
  } else {
    $Theme = $selection
  }
}
if ($Theme -notin $publicThemeIds) { Fail-TraeSkin "Theme is not available in the public menu: $Theme" }

$parameters = @{ Theme = $Theme }
if ($PortExplicit) { $parameters.Port = $Port }
if ($RestartExisting) { $parameters.RestartExisting = $true }
& (Join-Path $PSScriptRoot 'start-trae-skin-windows.ps1') @parameters
