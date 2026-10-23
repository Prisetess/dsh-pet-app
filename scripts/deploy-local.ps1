# Deploy / update the app into %LOCALAPPDATA%\DSH Pet (with a desktop shortcut).
#
# Why LocalAppData and not the project folder:
#   this machine refuses to execute binaries under the workspace dir, and Explorer-launched
#   copies of electron.exe from there never reached the main process (no log line at all).
#   Everything that must *execute* therefore lives outside the workspace; the app only reads
#   its code from this deployed copy and reuses the Electron runtime DSH already downloaded.
#
# NOTE: keep this file ASCII-only. Windows PowerShell 5.1 reads .ps1 as the OEM codepage,
# so non-ASCII comments/strings get mangled and can even break parsing.

param(
  [string]$Source = (Join-Path $PSScriptRoot '..'),
  [string]$Destination = (Join-Path $env:LOCALAPPDATA 'DSH Pet'),
  [switch]$SkipShortcut
)

$ErrorActionPreference = 'Stop'
$source = [System.IO.Path]::GetFullPath($Source)
$dest = [System.IO.Path]::GetFullPath($Destination)
$appDir = Join-Path $dest 'app'

Write-Host "[deploy] source: $source"
Write-Host "[deploy] dest  : $dest"

New-Item -ItemType Directory -Force -Path $appDir | Out-Null

# 1) app code (src / ui / vendor / package.json). vendor holds the plugin + 60 MB of assets.
foreach ($entry in @('src', 'ui', 'vendor')) {
  $from = Join-Path $source $entry
  if (-not (Test-Path -LiteralPath $from)) { continue }
  $to = Join-Path $appDir $entry
  Remove-Item -LiteralPath $to -Recurse -Force -ErrorAction SilentlyContinue
  Copy-Item -LiteralPath $from -Destination $to -Recurse -Force
}
Copy-Item -LiteralPath (Join-Path $source 'package.json') -Destination (Join-Path $appDir 'package.json') -Force

# foreground monitor used by the "hide when fullscreen" feature
$fgmon = Join-Path $source 'build\fgmon.exe'
if (Test-Path -LiteralPath $fgmon) {
  New-Item -ItemType Directory -Force -Path (Join-Path $appDir 'build') | Out-Null
  Copy-Item -LiteralPath $fgmon -Destination (Join-Path $appDir 'build\fgmon.exe') -Force
} else {
  Write-Host '[deploy] warning: build\fgmon.exe missing (fullscreen auto-hide disabled)'
}

# app icon: reused by the desktop shortcut and by the tray at runtime
$appIcon = Join-Path $source 'build\app.ico'
if (Test-Path -LiteralPath $appIcon) {
  Copy-Item -LiteralPath $appIcon -Destination (Join-Path $dest 'app.ico') -Force
} else {
  Write-Host '[deploy] warning: build\app.ico missing (shortcut keeps electron icon)'
}

# optional: official React settings page (only if it was built)
$uiReact = Join-Path $source 'ui-react\dist'
if (Test-Path -LiteralPath (Join-Path $uiReact 'index.html')) {
  $to = Join-Path $appDir 'ui-react\dist'
  New-Item -ItemType Directory -Force -Path (Split-Path $to) | Out-Null
  Remove-Item -LiteralPath $to -Recurse -Force -ErrorAction SilentlyContinue
  Copy-Item -LiteralPath $uiReact -Destination $to -Recurse -Force
  Write-Host '[deploy] included ui-react/dist'
}

# 2) launcher exe (embeds the deployed app dir)
& (Join-Path $PSScriptRoot 'build-launcher-project.ps1') -AppDir $appDir -OutFile (Join-Path $dest 'DSH Pet.exe')

# 3) sign it (cert is created on first run, then reused)
try {
  & (Join-Path $PSScriptRoot 'sign-portable.ps1') -Exe (Join-Path $dest 'DSH Pet.exe') | Out-Null
  Write-Host '[deploy] launcher signed'
} catch {
  Write-Host ('[deploy] signing skipped: ' + $_.Exception.Message)
}

# 4) fallback launcher (plain cmd: works even if new exes are blocked)
$bat = @(
  '@echo off',
  'rem Same as npm run start: the DSH-downloaded electron + this folder''s app.',
  'set "ELECTRON_RUN_AS_NODE="',
  'start "" "%USERPROFILE%\.dsh\electron\electron.exe" "%~dp0app"'
) -join "`r`n"
[System.IO.File]::WriteAllText((Join-Path $dest 'start.bat'), $bat, (New-Object System.Text.ASCIIEncoding))

# 5) desktop shortcut
if (-not $SkipShortcut) {
  $lnk = Join-Path ([Environment]::GetFolderPath('Desktop')) 'DSH Pet.lnk'
  $icon = Join-Path $dest 'app.ico'
  if (-not (Test-Path -LiteralPath $icon)) { $icon = Join-Path $dest 'DSH Pet.exe' }
  $ws = New-Object -ComObject WScript.Shell
  $s = $ws.CreateShortcut($lnk)
  $s.TargetPath = Join-Path $dest 'DSH Pet.exe'
  $s.WorkingDirectory = $dest
  $s.Description = 'DSH Pet'
  $s.IconLocation = "$icon,0"
  $s.Save()
  Write-Host "[deploy] shortcut: $lnk (icon: $icon)"
}

$size = (Get-ChildItem $appDir -Recurse -File | Measure-Object Length -Sum).Sum
Write-Host ('[deploy] done, app payload {0:N0} MB' -f ($size / 1MB))
Write-Host '[deploy] double-click the desktop "DSH Pet" shortcut'
