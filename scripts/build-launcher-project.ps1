# Build the project-folder launcher: DSH Pet.exe that runs the SAME command as `npm run start`.
#
# Why: on this machine the packaged copy of electron.exe refuses to start (silently, no JS log),
# while the DSH-downloaded one works. So this launcher just invokes the known-good one with
# this project directory as the app path -- no renaming, no copying of the runtime.

param(
  [string]$AppDir = (Join-Path $PSScriptRoot '..'),
  [string]$OutFile = (Join-Path $PSScriptRoot '..\DSH Pet.exe')
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$appDir = [System.IO.Path]::GetFullPath($AppDir).TrimEnd('\')
$outFile = [System.IO.Path]::GetFullPath($OutFile)
$csc = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $csc)) { Write-Error "csc.exe not found: $csc"; exit 1 }

$srcTemplate = Join-Path $PSScriptRoot 'launcher\Launcher-Project.cs'
$tempSrc = Join-Path ([System.IO.Path]::GetTempPath()) ("dsh-pet-launcher-" + [guid]::NewGuid().ToString('N') + ".cs")
# 占位符在 C# 的逐字字符串 @"..." 里，直接替换成单反斜杠路径即可（不要再转义一次）
(Get-Content -LiteralPath $srcTemplate -Raw) -replace '__APP_DIR__', $appDir | Set-Content -LiteralPath $tempSrc -Encoding UTF8

$ico = Join-Path $PSScriptRoot '..\build\app.ico'
if (-not (Test-Path -LiteralPath $ico)) { & (Join-Path $PSScriptRoot 'build-icon.ps1') }
if (-not (Test-Path -LiteralPath $ico)) {
  $logo = Join-Path $PSScriptRoot '..\vendor\plugin\assets\logo.png'
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
  $img.Dispose(); $bmp.Dispose()
  $fs = [System.IO.File]::Create($ico)
  $bw = New-Object System.IO.BinaryWriter($fs)
  $bw.Write([UInt16]0); $bw.Write([UInt16]1); $bw.Write([UInt16]1)
  $bw.Write([Byte]0); $bw.Write([Byte]0); $bw.Write([Byte]0); $bw.Write([Byte]0)
  $bw.Write([UInt16]1); $bw.Write([UInt16]32)
  $bw.Write([UInt32]$pngBytes.Length); $bw.Write([UInt32]22)
  $bw.Write($pngBytes); $bw.Close()
}

Write-Host "[launcher] app dir : $appDir"
Write-Host "[launcher] output  : $outFile"
& $csc /nologo /target:winexe /platform:anycpu /optimize+ "/out:$outFile" "/win32icon:$ico" /r:System.Windows.Forms.dll $tempSrc
if ($LASTEXITCODE -ne 0) { Write-Error "csc failed: $LASTEXITCODE"; exit 1 }
Remove-Item -LiteralPath $tempSrc -Force -ErrorAction SilentlyContinue

$info = Get-Item -LiteralPath $outFile
Write-Host ("[launcher] done: {0:N0} bytes" -f $info.Length)
