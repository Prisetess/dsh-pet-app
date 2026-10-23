# Build the DSH Pet launcher exe (offline, uses the .NET Framework csc that ships with Windows).
#
# Why a launcher instead of renaming electron.exe:
#   a renamed Electron binary is silently blocked by SmartScreen / AV heuristics on some machines
#   (process exits instantly, not even a main-process log line). This tiny exe is our own binary:
#   it just starts the unmodified electron.exe next to it with resources\app as the app path.
#
# Output: dist\DSH Pet\DSH Pet.exe  (~45 KB)

param(
  [string]$OutDir = (Join-Path $PSScriptRoot '..\dist\DSH Pet')
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$outDir = [System.IO.Path]::GetFullPath($OutDir)
if (-not (Test-Path -LiteralPath $outDir)) {
  Write-Error "output folder not found: $outDir (run 'npm run package' first)"
  exit 1
}

$csc = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $csc)) {
  Write-Error "csc.exe not found: $csc (need .NET Framework 4.x)"
  exit 1
}

$source = Join-Path $PSScriptRoot 'launcher\Launcher.cs'
$logo = Join-Path $PSScriptRoot '..\vendor\plugin\assets\logo.png'
$ico = Join-Path $PSScriptRoot '..\build\app.ico'
if (-not (Test-Path -LiteralPath $ico)) { & (Join-Path $PSScriptRoot 'build-icon.ps1') }
$exe = Join-Path $outDir 'DSH Pet.exe'

# --- icon: embed a 256x256 PNG inside a single-image .ico -------------------
if (-not (Test-Path -LiteralPath $ico)) {
  New-Item -ItemType Directory -Force -Path (Split-Path $ico) | Out-Null
  $img = [System.Drawing.Image]::FromFile((Resolve-Path $logo))
  $bmp = New-Object System.Drawing.Bitmap 256, 256
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.InterpolationMode = 'HighQualityBicubic'
  $g.DrawImage($img, 0, 0, 256, 256)
  $g.Dispose()
  $ms = New-Object System.IO.MemoryStream
  $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  $pngBytes = $ms.ToArray()
  $img.Dispose()
  $bmp.Dispose()
  $fs = [System.IO.File]::Create($ico)
  $bw = New-Object System.IO.BinaryWriter($fs)
  $bw.Write([UInt16]0); $bw.Write([UInt16]1); $bw.Write([UInt16]1)   # ICONDIR
  $bw.Write([Byte]0); $bw.Write([Byte]0); $bw.Write([Byte]0); $bw.Write([Byte]0)  # 256x256, no palette
  $bw.Write([UInt16]1); $bw.Write([UInt16]32)
  $bw.Write([UInt32]$pngBytes.Length); $bw.Write([UInt32]22)
  $bw.Write($pngBytes)
  $bw.Close()
  Write-Host "[launcher] icon written: $ico"
}

# --- compile --------------------------------------------------------------
Write-Host "[launcher] compiling $exe"
& $csc /nologo /target:winexe /platform:anycpu /optimize+ "/out:$exe" "/win32icon:$ico" /r:System.Windows.Forms.dll $source
if ($LASTEXITCODE -ne 0) {
  Write-Error "csc failed with exit code $LASTEXITCODE"
  exit 1
}

$info = Get-Item -LiteralPath $exe
Write-Host ("[launcher] done: {0} ({1:N0} bytes)" -f $exe, $info.Length)
Write-Host '[launcher] double-click DSH Pet.exe to start'
