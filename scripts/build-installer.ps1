# Build a single-file Windows installer for DSH Pet (offline, no electron-builder).
#
# Setup layout:
#   [ installer exe ][ payload.zip ][ 8-byte lo/hi? no: little-endian zip length ][ "DSHPETP1" magic ]
# The installer reads its own trailing bytes (accounting for the Authenticode certificate table
# and its alignment padding), so no NSIS / Inno / WiX is needed.
#
# Output: dist\DSH-Pet-Setup-<version>.exe
#
# IMPORTANT: keep this file ASCII-only. Windows PowerShell 5.1 reads .ps1 using the OEM
# codepage, so non-ASCII comments get mangled and can even merge lines together.

param(
  [string]$Version = '0.1.0',
  [string]$ElectronDist = (Join-Path $env:USERPROFILE '.dsh\electron')
)

$ErrorActionPreference = 'Stop'
$root = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$build = Join-Path $root 'build'
$stage = Join-Path $build 'installer-stage'
$zipPath = Join-Path $build 'payload.zip'
$setupRaw = Join-Path $build 'setup-raw.exe'
$distDir = Join-Path $root 'dist'
$outFile = Join-Path $distDir ("DSH-Pet-Setup-$Version.exe")
$csc = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$magicText = 'DSHPETP1'

function Say($message) { Write-Host "[installer] $message" }

if (-not (Test-Path -LiteralPath (Join-Path $ElectronDist 'electron.exe'))) {
  Write-Error "electron dist not found: $ElectronDist (set -ElectronDist)"
  exit 1
}
if (-not (Test-Path -LiteralPath (Join-Path $root 'vendor\plugin\lib\index.js'))) {
  Write-Error "vendor/plugin missing: run 'npm run vendor' first"
  exit 1
}
if (-not (Test-Path -LiteralPath $csc)) { Write-Error "csc.exe not found: $csc"; exit 1 }

Add-Type -AssemblyName System.IO.Compression.FileSystem
Add-Type -AssemblyName System.Drawing

# ---------------------------------------------------------------- stage payload
Say "staging payload -> $stage"
if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
New-Item -ItemType Directory -Force -Path $stage | Out-Null

Say '  copying electron runtime'
Copy-Item -Path (Join-Path $ElectronDist '*') -Destination $stage -Recurse -Force

Say '  copying app code'
$appDir = Join-Path $stage 'resources\app'
New-Item -ItemType Directory -Force -Path $appDir | Out-Null
foreach ($entry in @('src', 'ui', 'vendor')) {
  Copy-Item -LiteralPath (Join-Path $root $entry) -Destination (Join-Path $appDir $entry) -Recurse -Force
}
Copy-Item -LiteralPath (Join-Path $root 'package.json') -Destination (Join-Path $appDir 'package.json') -Force
# Fullscreen monitor helper (used by "hide when fullscreen"); without it that feature stays off.
$fgmon = Join-Path $root 'build\fgmon.exe'
if (Test-Path -LiteralPath $fgmon) {
  New-Item -ItemType Directory -Force -Path (Join-Path $appDir 'build') | Out-Null
  Copy-Item -LiteralPath $fgmon -Destination (Join-Path $appDir 'build\fgmon.exe') -Force
} else {
  Say '  WARNING: build\fgmon.exe missing (fullscreen auto-hide disabled)'
}
$uiReact = Join-Path $root 'ui-react\dist'
if (Test-Path -LiteralPath (Join-Path $uiReact 'index.html')) {
  Copy-Item -LiteralPath $uiReact -Destination (Join-Path $appDir 'ui-react\dist') -Recurse -Force
  Say '  included ui-react/dist'
}

# app icon (256x256 png wrapped in a single-image .ico)
$ico = Join-Path $build 'app.ico'
# Regenerate from the source artwork when missing (multi-size DIB icon; see scripts/build-icon.ps1).
if (-not (Test-Path -LiteralPath $ico)) { & (Join-Path $PSScriptRoot 'build-icon.ps1') }
if (-not (Test-Path -LiteralPath $ico)) {
  $logo = Join-Path $root 'vendor\plugin\assets\logo.png'
  $img = [System.Drawing.Image]::FromFile((Resolve-Path $logo))
  $bmp = New-Object System.Drawing.Bitmap 256, 256
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.InterpolationMode = 'HighQualityBicubic'
  $g.DrawImage($img, 0, 0, 256, 256)
  $g.Dispose()
  $ms = New-Object System.IO.MemoryStream
  $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  $pngBytes = $ms.ToArray()
  $img.Dispose(); $bmp.Dispose()
  $fs = [System.IO.File]::Create($ico)
  $bw = New-Object System.IO.BinaryWriter($fs)
  $bw.Write([UInt16]0); $bw.Write([UInt16]1); $bw.Write([UInt16]1)
  $bw.Write([Byte]0); $bw.Write([Byte]0); $bw.Write([Byte]0); $bw.Write([Byte]0)
  $bw.Write([UInt16]1); $bw.Write([UInt16]32)
  $bw.Write([UInt32]$pngBytes.Length); $bw.Write([UInt32]22)
  $bw.Write($pngBytes); $bw.Close()
}

Say '  compiling launcher (DSH Pet.exe)'
& $csc /nologo /target:winexe /platform:anycpu /optimize+ "/out:$(Join-Path $stage 'DSH Pet.exe')" "/win32icon:$ico" /r:System.Windows.Forms.dll (Join-Path $root 'scripts\launcher\Launcher.cs')
if ($LASTEXITCODE -ne 0) { Write-Error 'launcher compile failed'; exit 1 }

Say '  compiling uninstaller (uninstall.exe)'
& $csc /nologo /target:winexe /platform:anycpu /optimize+ "/out:$(Join-Path $stage 'uninstall.exe')" "/win32icon:$ico" "/win32manifest:$(Join-Path $root 'scripts\installer\uninstaller.manifest')" /r:System.Windows.Forms.dll (Join-Path $root 'scripts\installer\Uninstaller.cs')
if ($LASTEXITCODE -ne 0) { Write-Error 'uninstaller compile failed'; exit 1 }

$readme = @(
  'DSH Pet',
  '',
  'Start from the desktop / Start-menu shortcut (it runs electron.exe with resources\app).',
  '"DSH Pet.exe" in this folder is a fallback launcher if the shortcut is blocked.',
  '',
  'First launch may show a Windows SmartScreen / Defender prompt once:',
  'click "More info" -> "Run anyway", or "Allow". It will not ask again.',
  '',
  'Right-click the pet -> Settings to change size / position / physics.',
  'Tray icon: Settings / Reload / Config folder / Quit.',
  '',
  'Uninstall: run uninstall.exe here, or use "Apps and features" in Windows.',
  'Config: %USERPROFILE%\.dsh\dsh-pet\main-config.jsonc (kept after uninstall).'
) -join "`r`n"
[System.IO.File]::WriteAllText((Join-Path $stage 'readme.txt'), $readme, (New-Object System.Text.UTF8Encoding($true)))

# ---------------------------------------------------------------- zip payload
Say 'zipping payload (this takes a few minutes)'
if (Test-Path -LiteralPath $zipPath) { Remove-Item -LiteralPath $zipPath -Force }
[System.IO.Compression.ZipFile]::CreateFromDirectory(
  $stage, $zipPath, [System.IO.Compression.CompressionLevel]::Optimal, $false)
$zipSize = (Get-Item -LiteralPath $zipPath).Length
Say ('  payload.zip: {0:N0} MB' -f ($zipSize / 1MB))

# ---------------------------------------------------------------- compile installer
Say 'compiling installer'
if (Test-Path -LiteralPath $setupRaw) { Remove-Item -LiteralPath $setupRaw -Force }
& $csc /nologo /target:winexe /platform:anycpu /optimize+ "/out:$setupRaw" "/win32icon:$ico" "/win32manifest:$(Join-Path $root 'scripts\installer\installer.manifest')" `
  /r:System.Windows.Forms.dll /r:System.Drawing.dll /r:System.IO.Compression.dll /r:System.IO.Compression.FileSystem.dll `
  (Join-Path $root 'scripts\installer\Installer.cs')
if ($LASTEXITCODE -ne 0) { Write-Error 'installer compile failed'; exit 1 }

# ---------------------------------------------------------------- append payload
Say 'appending payload to setup exe'
New-Item -ItemType Directory -Force -Path $distDir | Out-Null
if (Test-Path -LiteralPath $outFile) { Remove-Item -LiteralPath $outFile -Force }

$out = [System.IO.File]::Create($outFile)
try {
  $in = [System.IO.File]::OpenRead($setupRaw)
  $in.CopyTo($out)
  $in.Close()

  $in = [System.IO.File]::OpenRead($zipPath)
  $in.CopyTo($out)
  $in.Close()

  $lengthBytes = [BitConverter]::GetBytes([Int64]$zipSize)
  $out.Write($lengthBytes, 0, 8)

  $magicBytes = [System.Text.Encoding]::ASCII.GetBytes($magicText)
  $out.Write($magicBytes, 0, 8)
} finally {
  $out.Close()
}

$total = (Get-Item -LiteralPath $outFile).Length
Say ('  setup: {0}  ({1:N0} MB)' -f $outFile, ($total / 1MB))

# ---------------------------------------------------------------- sign
try {
  & (Join-Path $PSScriptRoot 'sign-portable.ps1') -Exe $outFile | Out-Null
  Say 'setup signed'
} catch {
  Say ("signing skipped: " + $_.Exception.Message)
}

# ---------------------------------------------------------------- test variant (no manifest)
# Same code without the manifest so automated tests can run it non-interactively.
$testRaw = Join-Path $build 'setup-test-raw.exe'
$testExe = Join-Path $build 'setup-test.exe'
& $csc /nologo /target:winexe /platform:anycpu /optimize+ "/out:$testRaw" "/win32icon:$ico" `
  /r:System.Windows.Forms.dll /r:System.Drawing.dll /r:System.IO.Compression.dll /r:System.IO.Compression.FileSystem.dll `
  (Join-Path $root 'scripts\installer\Installer.cs')
if ($LASTEXITCODE -eq 0) {
  $sink = [System.IO.File]::Create($testExe)
  try {
    $src = [System.IO.File]::OpenRead($testRaw); $src.CopyTo($sink); $src.Close()
    $src = [System.IO.File]::OpenRead($zipPath); $src.CopyTo($sink); $src.Close()
    $sink.Write([BitConverter]::GetBytes([Int64]$zipSize), 0, 8)
    $sink.Write([System.Text.Encoding]::ASCII.GetBytes($magicText), 0, 8)
  } finally { $sink.Close() }
  Say '  test variant: build\setup-test.exe'
}

Say 'done. Silent install: setup.exe /S /D=C:\path\to\dir'